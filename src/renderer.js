let providers = {};
let occupiedSlots = [];
let result = null;
let activeView = 'markdown';

const byId = (id) => document.getElementById(id);
const status = byId('status');
const preview = byId('preview');

function config() {
  return {
    baseUrl: byId('baseUrl').value.trim(),
    apiKey: byId('apiKey').value.trim(),
    model: byId('model').value.trim(),
  };
}

function options() {
  return {
    audience: byId('audience').value.trim(),
    subject: byId('subject').value.trim(),
    goal: byId('goal').value.trim(),
    startDate: byId('startDate').value,
    endDate: byId('endDate').value,
    timeSlots: byId('timeSlots').value.trim(),
    constraints: byId('constraints').value.trim(),
    occupiedSlots,
  };
}

function setBusy(busy, message = '') {
  byId('generate').disabled = busy;
  byId('analyze').disabled = busy || byId('sourceStatus').dataset.selected !== 'true';
  status.textContent = message;
  status.classList.toggle('error', false);
}

function setError(message) {
  status.textContent = message;
  status.classList.add('error');
}

function renderResult() {
  if (!result) return;
  preview.textContent = activeView === 'markdown' ? result.markdown : JSON.stringify(result.schedule, null, 2);
  byId('showMarkdown').classList.toggle('selected', activeView === 'markdown');
  byId('showJson').classList.toggle('selected', activeView === 'json');
}

function renderOccupied() {
  const container = byId('occupied');
  container.hidden = occupiedSlots.length === 0;
  container.replaceChildren(...occupiedSlots.map((slot) => {
    const item = document.createElement('span');
    item.textContent = `${slot.weekday} ${slot.startTime}-${slot.endTime} ${slot.title || ''}`;
    return item;
  }));
}

async function initialize() {
  providers = await window.scheduleApp.getProviders();
  Object.keys(providers).forEach((key) => {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = { openai: 'OpenAI', deepseek: 'DeepSeek', kimi: 'Kimi', siliconflow: '硅基流动', custom: '自定义' }[key];
    byId('provider').append(option);
  });
  byId('provider').value = 'deepseek';
  byId('provider').dispatchEvent(new Event('change'));
  const now = new Date();
  const later = new Date(now); later.setMonth(later.getMonth() + 3);
  byId('startDate').value = now.toISOString().slice(0, 10);
  byId('endDate').value = later.toISOString().slice(0, 10);
}

byId('provider').addEventListener('change', () => {
  const preset = providers[byId('provider').value];
  byId('baseUrl').value = preset.baseUrl;
  byId('model').value = preset.model;
});

byId('selectTimetable').addEventListener('click', async () => {
  setBusy(true, '正在读取课表...');
  const selected = await window.scheduleApp.selectTimetable();
  setBusy(false);
  if (selected.canceled) return;
  if (selected.error) return setError(selected.error);
  byId('sourceStatus').textContent = `${selected.name} · ${selected.pageCount}/${selected.totalPages} 页`;
  byId('sourceStatus').dataset.selected = 'true';
  byId('analyze').disabled = false;
  occupiedSlots = [];
  renderOccupied();
});

byId('analyze').addEventListener('click', async () => {
  setBusy(true, '视觉模型正在识别固定课程...');
  const analyzed = await window.scheduleApp.analyzeTimetable(config());
  setBusy(false);
  if (!analyzed.ok) return setError(analyzed.error);
  occupiedSlots = analyzed.occupiedSlots;
  renderOccupied();
  status.textContent = `已识别 ${occupiedSlots.length} 个占用时段，生成时将自动避开。`;
});

byId('generator').addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true, '正在生成并校验课表...');
  const generated = await window.scheduleApp.generate({ config: config(), options: options() });
  setBusy(false);
  if (!generated.ok) return setError(generated.error);
  result = generated;
  activeView = 'markdown';
  renderResult();
  byId('save').disabled = false;
  status.textContent = `已生成 ${generated.schedule.lessons.length} 个学习日。`;
});

byId('showMarkdown').addEventListener('click', () => { activeView = 'markdown'; renderResult(); });
byId('showJson').addEventListener('click', () => { activeView = 'json'; renderResult(); });
byId('save').addEventListener('click', async () => {
  if (!result) return;
  const saved = await window.scheduleApp.save(result.markdown, result.schedule.title.replace(/[\\/:*?"<>|]/g, '-'));
  if (!saved.canceled) status.textContent = `已保存：${saved.filePath}`;
});

initialize();
