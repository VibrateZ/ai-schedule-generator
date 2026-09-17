function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function clean(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function dateParts(value) {
  const match = /^(20\d{2})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { date, weekday: `周${'日一二三四五六'[date.getUTCDay()]}` };
}

function clockMinutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function validateOccupiedSlots(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw new Error('占用时段必须是数组');
  return input.map((slot, index) => {
    const weekday = clean(slot?.weekday);
    const startTime = clean(slot?.startTime);
    const endTime = clean(slot?.endTime);
    if (!/^周[一二三四五六日]$/.test(weekday)) throw new Error(`第 ${index + 1} 个占用时段的星期无效`);
    const start = clockMinutes(startTime);
    const end = clockMinutes(endTime);
    if (start == null || end == null) throw new Error(`第 ${index + 1} 个占用时段的时间无效`);
    if (end <= start) throw new Error(`第 ${index + 1} 个占用时段的结束时间必须晚于开始时间`);
    return { weekday, startTime, endTime, title: clean(slot.title) };
  });
}

function validateSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('AI 返回内容不是 JSON 对象');
  if (!Array.isArray(input.lessons) || input.lessons.length === 0) throw new Error('JSON 中缺少非空 lessons 数组');
  const lessons = input.lessons.map((lesson, index) => {
    const date = clean(lesson.date);
    const startTime = clean(lesson.startTime);
    const topic = clean(lesson.topic);
    const parsedDate = dateParts(date);
    if (!parsedDate) throw new Error(`第 ${index + 1} 节课日期无效`);
    const start = clockMinutes(startTime);
    if (start == null) throw new Error(`第 ${index + 1} 节课时间格式错误`);
    if (!topic) throw new Error(`第 ${index + 1} 节课缺少 topic`);
    const suppliedWeekday = clean(lesson.weekday);
    if (!suppliedWeekday) throw new Error(`第 ${index + 1} 节课缺少 weekday`);
    if (suppliedWeekday !== parsedDate.weekday) {
      throw new Error(`第 ${index + 1} 节课的星期与日期不一致`);
    }
    const { durationMinutes } = lesson;
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 240) {
      throw new Error(`第 ${index + 1} 节课时长必须是 15 至 240 的整数分钟`);
    }
    if (start + durationMinutes > 24 * 60) throw new Error(`第 ${index + 1} 节课不能跨越午夜`);
    const resources = Array.isArray(lesson.resources)
      ? lesson.resources.filter((item) => item && isWebUrl(item.url)).map((item) => ({
        title: clean(item.title, '课程资源'),
        url: item.url,
        type: clean(item.type, 'document'),
      }))
      : [];
    return {
      date,
      weekday: parsedDate.weekday,
      startTime,
      durationMinutes,
      course: clean(lesson.course, clean(input.subject, '课程')),
      topic,
      tasks: Array.isArray(lesson.tasks) ? lesson.tasks.map((item) => clean(item)).filter(Boolean) : [],
      resources,
    };
  });
  lessons.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  for (let index = 1; index < lessons.length; index += 1) {
    const previous = lessons[index - 1];
    const current = lessons[index];
    if (previous.date === current.date && clockMinutes(current.startTime) < clockMinutes(previous.startTime) + previous.durationMinutes) {
      throw new Error(`课程时间重叠：${previous.date} ${previous.startTime} 与 ${current.startTime}`);
    }
  }
  return {
    version: 1,
    title: clean(input.title, 'AI 学习课表'),
    timezone: clean(input.timezone, 'Asia/Shanghai'),
    audience: clean(input.audience),
    subject: clean(input.subject),
    lessons,
  };
}

function availableSlotKeys(value) {
  if (typeof value !== 'string') return new Set();
  const matches = [...value.matchAll(/周[一二三四五六日]/g)];
  const keys = new Set();
  matches.forEach((match, index) => {
    const segmentEnd = matches[index + 1]?.index ?? value.length;
    const segment = value.slice(match.index + match[0].length, segmentEnd);
    (segment.match(/(?:[01]\d|2[0-3]):[0-5]\d/g) || []).forEach((time) => keys.add(`${match[0]}|${time}`));
  });
  return keys;
}

function validateScheduleConstraints(schedule, options) {
  const start = clean(options?.startDate);
  const end = clean(options?.endDate);
  if (!dateParts(start) || !dateParts(end) || start > end) throw new Error('学习日期范围无效');
  const allowedSlots = availableSlotKeys(options?.timeSlots);
  if (!allowedSlots.size) throw new Error('可用时段格式无效，请使用“周一 10:10，周二 16:00”格式');
  schedule.lessons.forEach((lesson, index) => {
    if (lesson.date < start || lesson.date > end) throw new Error(`第 ${index + 1} 节课超出选择的日期范围`);
    if (!allowedSlots.has(`${lesson.weekday}|${lesson.startTime}`)) {
      throw new Error(`第 ${index + 1} 节课不在允许的学习时段内`);
    }
  });
  return schedule;
}

function minutes(value) {
  return clockMinutes(value);
}

function findConflicts(schedule, occupiedSlots) {
  const normalizedSlots = validateOccupiedSlots(occupiedSlots);
  const conflicts = [];
  schedule.lessons.forEach((lesson) => {
    const lessonStart = minutes(lesson.startTime);
    const lessonEnd = lessonStart + lesson.durationMinutes;
    normalizedSlots.forEach((slot) => {
      if (slot.weekday !== lesson.weekday) return;
      const slotStart = minutes(slot.startTime);
      const slotEnd = minutes(slot.endTime);
      if (lessonStart < slotEnd && slotStart < lessonEnd) {
        conflicts.push({ lesson: `${lesson.date} ${lesson.startTime} ${lesson.topic}`, occupied: `${slot.weekday} ${slot.startTime}-${slot.endTime} ${slot.title || ''}` });
      }
    });
  });
  return conflicts;
}

function enrichResources(schedule) {
  const mathPattern = /数学|微积分|线性代数|高数/;
  schedule.lessons.forEach((lesson) => {
    if (mathPattern.test(`${schedule.subject} ${lesson.course} ${lesson.topic}`)) {
      const url = /矩阵|向量|线性|特征|行列式|正交/.test(lesson.topic)
        ? 'https://www.icourse163.org/course/TONGJI-481001'
        : 'https://www.icourse163.org/course/SDU-190001';
      if (!lesson.resources.some((resource) => resource.url === url)) {
        lesson.resources.unshift({ title: '中国大学 MOOC 主课', url, type: 'course' });
      }
    }
    const query = encodeURIComponent(`${schedule.audience} ${schedule.subject} ${lesson.topic} 教程`);
    const searchResources = [
      { title: 'B站中文视频检索', url: `https://search.bilibili.com/all?keyword=${query}`, type: 'search' },
      { title: '必应教学资料检索', url: `https://cn.bing.com/search?q=${query}`, type: 'search' },
    ];
    searchResources.forEach((resource) => {
      if (!lesson.resources.some((item) => item.url === resource.url)) lesson.resources.push(resource);
    });
  });
  return schedule;
}

function decodeXml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function resourceHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isTrustedResource(value) {
  const host = resourceHost(value);
  return host.endsWith('.edu.cn') || host.endsWith('.edu') || host === 'edu.cn'
    || /(^|\.)icourse163\.org$/.test(host)
    || /(^|\.)bilibili\.com$/.test(host)
    || /(^|\.)smartedu\.cn$/.test(host);
}

function isBlockedResource(value) {
  const host = resourceHost(value);
  return /(^|\.)(bing\.com|baike\.baidu\.com|zhidao\.baidu\.com|hao86\.com|x\.com|twitter\.com)$/.test(host);
}

function topicTokens(topic) {
  const compact = topic.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, '');
  const tokens = new Set((topic.match(/[A-Za-z0-9]{3,}/g) || []).map((value) => value.toLowerCase()));
  for (let index = 0; index < compact.length - 1; index += 1) tokens.add(compact.slice(index, index + 2));
  return [...tokens];
}

async function fetchTextWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('resource request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        return { response, text: await response.text() };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function searchResources(schedule, fetchImpl = fetch, timeoutMs = 10000) {
  await Promise.all(schedule.lessons.map(async (lesson) => {
    const query = encodeURIComponent(`"${lesson.topic}" ${schedule.subject} 教程 讲义 视频`);
    try {
      const { response, text: xml } = await fetchTextWithTimeout(fetchImpl, `https://cn.bing.com/search?format=rss&q=${query}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 CourseScheduleGenerator/0.1' },
      }, timeoutMs);
      if (!response.ok) return;
      const tokens = topicTokens(lesson.topic);
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g)]
        .map((match) => ({ title: decodeXml(match[1]).replace(/<!\[CDATA\[|]]>/g, '').trim(), url: decodeXml(match[2]).trim(), type: 'search-result' }))
        .filter((item) => {
          if (!isWebUrl(item.url) || isBlockedResource(item.url)) return false;
          const title = item.title.toLowerCase();
          return isTrustedResource(item.url) && tokens.some((token) => title.includes(token));
        })
        .sort((a, b) => {
          const score = (item) => (isTrustedResource(item.url) ? 4 : 0)
            + (/\.pdf(?:$|[?#])/i.test(item.url) ? 2 : 0)
            + (tokens.some((token) => item.title.toLowerCase().includes(token)) ? 1 : 0);
          return score(b) - score(a);
        })
        .slice(0, 2);
      items.reverse().forEach((item) => {
        if (!lesson.resources.some((resource) => resource.url === item.url)) lesson.resources.unshift(item);
      });
    } catch {
      // The deterministic search links added by enrichResources remain available offline.
    }
  }));
  return schedule;
}

function markdownCell(value) {
  return String(value || '').replaceAll('|', '｜').replaceAll('\n', ' ');
}

function toMarkdown(schedule) {
  const lines = [
    `# ${markdownCell(schedule.title)}`,
    '',
    `- 适用对象：${markdownCell(schedule.audience)}`,
    `- 学科：${markdownCell(schedule.subject)}`,
    `- 时区：${markdownCell(schedule.timezone)}`,
    '',
    '| 日期 | 星期 | 时间 | 课程 | 学习内容 | 资源链接 |',
    '|---|---|---|---|---|---|',
  ];
  schedule.lessons.forEach((lesson) => {
    const task = [lesson.topic, ...lesson.tasks].filter(Boolean).join('；');
    const links = lesson.resources.map((resource) => `[${markdownCell(resource.title)}](${resource.url})`).join(' ');
    lines.push(`| ${lesson.date} | ${lesson.weekday} | ${lesson.startTime} | ${markdownCell(lesson.course)} | ${markdownCell(task)} | ${links} |`);
  });
  return `${lines.join('\n')}\n`;
}

module.exports = {
  enrichResources,
  findConflicts,
  isWebUrl,
  searchResources,
  toMarkdown,
  validateOccupiedSlots,
  validateSchedule,
  validateScheduleConstraints,
};
