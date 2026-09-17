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

function validateSchedule(input) {
  if (!input || typeof input !== 'object') throw new Error('AI 返回内容不是 JSON 对象');
  if (!Array.isArray(input.lessons) || input.lessons.length === 0) throw new Error('JSON 中缺少非空 lessons 数组');
  const lessons = input.lessons.map((lesson, index) => {
    const date = clean(lesson.date);
    const startTime = clean(lesson.startTime);
    const topic = clean(lesson.topic);
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new Error(`第 ${index + 1} 节课日期格式错误`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new Error(`第 ${index + 1} 节课时间格式错误`);
    if (!topic) throw new Error(`第 ${index + 1} 节课缺少 topic`);
    const resources = Array.isArray(lesson.resources)
      ? lesson.resources.filter((item) => item && isWebUrl(item.url)).map((item) => ({
        title: clean(item.title, '课程资源'),
        url: item.url,
        type: clean(item.type, 'document'),
      }))
      : [];
    return {
      date,
      weekday: clean(lesson.weekday, `周${'日一二三四五六'[new Date(`${date}T00:00:00`).getDay()]}`),
      startTime,
      durationMinutes: Number.isFinite(Number(lesson.durationMinutes)) ? Math.max(15, Math.min(240, Number(lesson.durationMinutes))) : 60,
      course: clean(lesson.course, clean(input.subject, '课程')),
      topic,
      tasks: Array.isArray(lesson.tasks) ? lesson.tasks.map((item) => clean(item)).filter(Boolean) : [],
      resources,
    };
  });
  return {
    version: 1,
    title: clean(input.title, 'AI 学习课表'),
    timezone: clean(input.timezone, 'Asia/Shanghai'),
    audience: clean(input.audience),
    subject: clean(input.subject),
    lessons: lessons.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`)),
  };
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function findConflicts(schedule, occupiedSlots) {
  if (!Array.isArray(occupiedSlots)) return [];
  const conflicts = [];
  schedule.lessons.forEach((lesson) => {
    const lessonStart = minutes(lesson.startTime);
    const lessonEnd = lessonStart + lesson.durationMinutes;
    occupiedSlots.forEach((slot) => {
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

async function searchResources(schedule, fetchImpl = fetch) {
  await Promise.all(schedule.lessons.map(async (lesson) => {
    const query = encodeURIComponent(`"${lesson.topic}" ${schedule.subject} 教程 讲义 视频`);
    try {
      const response = await fetchImpl(`https://cn.bing.com/search?format=rss&q=${query}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 CourseScheduleGenerator/0.1' },
      });
      if (!response.ok) return;
      const xml = await response.text();
      const items = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<\/item>/g)]
        .map((match) => ({ title: decodeXml(match[1]).replace(/<!\[CDATA\[|]]>/g, '').trim(), url: decodeXml(match[2]).trim(), type: 'search-result' }))
        .filter((item) => isWebUrl(item.url) && !/(bing\.com\/search|baike\.baidu\.com|hao86\.com|zhidao\.baidu\.com)/.test(item.url))
        .sort((a, b) => {
          const score = (item) => /icourse163\.org|bilibili\.com|smartedu\.cn|edu\.cn/.test(item.url) ? 1 : 0;
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

module.exports = { enrichResources, findConflicts, isWebUrl, searchResources, toMarkdown, validateSchedule };
