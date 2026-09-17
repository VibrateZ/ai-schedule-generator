const assert = require('node:assert/strict');
const { requestChat } = require('../src/provider-client');
const {
  enrichResources,
  findConflicts,
  searchResources,
  toMarkdown,
  validateOccupiedSlots,
  validateSchedule,
  validateScheduleConstraints,
} = require('../src/schedule');

function lesson(overrides = {}) {
  return {
    date: '2026-09-21',
    weekday: '周一',
    startTime: '10:10',
    durationMinutes: 60,
    course: '微积分',
    topic: '函数与极限',
    tasks: ['完成 6 题'],
    resources: [{ title: '主课', url: 'https://example.com/course', type: 'course' }],
    ...overrides,
  };
}

async function main() {
  const schedule = validateSchedule({
    title: '大一数学计划',
    audience: '大学一年级',
    subject: '数学',
    lessons: [lesson()],
  });

  assert.equal(schedule.lessons.length, 1);
  assert.equal(schedule.lessons[0].durationMinutes, 60);
  assert.equal(findConflicts(schedule, [{ weekday: '周一', startTime: '09:50', endTime: '10:30', title: '固定课' }]).length, 1);
  assert.equal(findConflicts(schedule, [{ weekday: '周二', startTime: '09:50', endTime: '10:30', title: '固定课' }]).length, 0);
  assert.equal(findConflicts(schedule, [{ weekday: '周一', startTime: '09:10', endTime: '10:10', title: '相邻课程' }]).length, 0);

  enrichResources(schedule);
  assert.ok(schedule.lessons[0].resources.length >= 3);
  const markdown = toMarkdown(schedule);
  assert.match(markdown, /\| 2026-09-21 \| 周一 \| 10:10 \|/);
  assert.match(markdown, /\[主课\]\(https:\/\/example.com\/course\)/);

  assert.throws(() => validateSchedule({ lessons: [] }), /lessons/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ date: '2026-02-31' })] }), /日期无效/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ weekday: '周二' })] }), /星期与日期不一致/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ weekday: undefined })] }), /缺少 weekday/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ durationMinutes: '60' })] }), /整数分钟/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ durationMinutes: 60.5 })] }), /整数分钟/);
  assert.throws(() => validateSchedule({ lessons: [lesson({ startTime: '23:30', durationMinutes: 60 })] }), /跨越午夜/);
  assert.throws(() => validateSchedule({ lessons: [
    lesson(),
    lesson({ startTime: '10:30', topic: '重叠课程' }),
  ] }), /课程时间重叠/);
  assert.doesNotThrow(() => validateSchedule({ lessons: [
    lesson(),
    lesson({ startTime: '11:10', topic: '相邻课程' }),
  ] }));

  assert.throws(() => validateOccupiedSlots([{ weekday: '周一', startTime: '99:99', endTime: '10:00' }]), /时间无效/);
  assert.throws(() => validateOccupiedSlots([{ weekday: '周一', startTime: 'aa:bb', endTime: '10:00' }]), /时间无效/);
  assert.throws(() => validateOccupiedSlots([{ weekday: '周一', startTime: '10:00', endTime: '09:00' }]), /结束时间/);

  assert.equal(validateScheduleConstraints(schedule, {
    startDate: '2026-09-21',
    endDate: '2026-09-25',
    timeSlots: '周一 08:00或10:10，周二 16:00',
  }), schedule);
  assert.throws(() => validateScheduleConstraints(schedule, {
    startDate: '2026-09-22',
    endDate: '2026-09-25',
    timeSlots: '周一 10:10',
  }), /超出选择的日期范围/);
  assert.throws(() => validateScheduleConstraints(schedule, {
    startDate: '2026-09-21',
    endDate: '2026-09-25',
    timeSlots: '周一 14:00',
  }), /不在允许的学习时段内/);

  const fakeFetch = async () => ({
    ok: true,
    text: async () => `<rss><channel>
      <item><title>函数与极限高质量教程</title><link>https://example.edu/tutorial.pdf</link></item>
      <item><title>校园食堂菜单</title><link>https://food.example.edu/menu</link></item>
      <item><title>X Help Center</title><link>https://help.x.com/zh-cn/using-x</link></item>
      <item><title>完全无关页面</title><link>https://example.com/unrelated</link></item>
    </channel></rss>`,
  });
  await searchResources(schedule, fakeFetch);
  assert.ok(schedule.lessons[0].resources.some((item) => item.url === 'https://example.edu/tutorial.pdf'));
  assert.ok(!schedule.lessons[0].resources.some((item) => item.url.includes('help.x.com')));
  assert.ok(!schedule.lessons[0].resources.some((item) => item.url.includes('food.example.edu')));
  assert.ok(!schedule.lessons[0].resources.some((item) => item.url.endsWith('/unrelated')));

  let aborted = false;
  const hangingFetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    });
  });
  await searchResources(schedule, hangingFetch, 10);
  assert.equal(aborted, true);

  const hangingBodyFetch = async () => ({
    ok: true,
    text: async () => new Promise(() => {}),
  });
  const started = Date.now();
  await searchResources(schedule, hangingBodyFetch, 10);
  assert.ok(Date.now() - started < 100, '资源正文读取必须受超时限制');

  const successfulFetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: '{"lessons":[]}' } }] }),
  });
  assert.deepEqual(await requestChat(
    { baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model' },
    [{ role: 'user', content: 'test' }],
    0,
    { fetchImpl: successfulFetch, timeoutMs: 100 },
  ), { lessons: [] });

  let apiCalls = 0;
  const retryThenHang = async () => {
    apiCalls += 1;
    if (apiCalls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { ok: false, status: 400, text: async () => 'unsupported response_format' };
    }
    return { ok: true, status: 200, text: async () => new Promise(() => {}) };
  };
  const apiStarted = Date.now();
  await assert.rejects(() => requestChat(
    { baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', model: 'test-model' },
    [{ role: 'user', content: 'test' }],
    0,
    { fetchImpl: retryThenHang, timeoutMs: 80 },
  ), /超时/);
  assert.ok(Date.now() - apiStarted < 130, '重试必须共享同一个 API 超时预算');

  console.log('schedule: all tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
