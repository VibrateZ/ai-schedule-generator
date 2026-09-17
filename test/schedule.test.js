const assert = require('node:assert/strict');
const { enrichResources, findConflicts, searchResources, toMarkdown, validateSchedule } = require('../src/schedule');

const schedule = validateSchedule({
  title: '大一数学计划',
  audience: '大学一年级',
  subject: '数学',
  lessons: [{
    date: '2026-09-21',
    weekday: '周一',
    startTime: '10:10',
    durationMinutes: 60,
    course: '微积分',
    topic: '函数与极限',
    tasks: ['完成 6 题'],
    resources: [{ title: '主课', url: 'https://example.com/course', type: 'course' }],
  }],
});

assert.equal(schedule.lessons.length, 1);
assert.equal(schedule.lessons[0].durationMinutes, 60);
assert.equal(findConflicts(schedule, [{ weekday: '周一', startTime: '09:50', endTime: '10:30', title: '固定课' }]).length, 1);
assert.equal(findConflicts(schedule, [{ weekday: '周二', startTime: '09:50', endTime: '10:30', title: '固定课' }]).length, 0);

enrichResources(schedule);
assert.ok(schedule.lessons[0].resources.length >= 3);
const markdown = toMarkdown(schedule);
assert.match(markdown, /\| 2026-09-21 \| 周一 \| 10:10 \|/);
assert.match(markdown, /\[主课\]\(https:\/\/example.com\/course\)/);
assert.throws(() => validateSchedule({ lessons: [] }), /lessons/);

const fakeFetch = async () => ({
  ok: true,
  text: async () => '<rss><channel><item><title>高质量教程</title><link>https://example.edu/tutorial</link></item></channel></rss>',
});
searchResources(schedule, fakeFetch).then(() => {
  assert.ok(schedule.lessons[0].resources.some((item) => item.url === 'https://example.edu/tutorial'));
  console.log('schedule: all tests passed');
});
