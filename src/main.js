const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { enrichResources, findConflicts, toMarkdown, validateSchedule } = require('./schedule');
const { pdfToImages } = require('./pdf-renderer');

let mainWindow;
let selectedTimetable = null;

const providerDefaults = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-8B' },
  custom: { baseUrl: '', model: '' },
};

function endpointFor(baseUrl) {
  const value = baseUrl.replace(/\/+$/, '');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('API 地址必须使用 HTTPS；本地 localhost 可使用 HTTP');
  }
  return value.endsWith('/chat/completions') ? value : `${value}/chat/completions`;
}

function buildPrompt(options) {
  return `你是严谨的大学课程设计师。为以下用户生成学习课表，并仅输出一个 JSON 对象，不要使用 Markdown 代码块。

用户条件：
- 年级/阶段：${options.audience}
- 学科：${options.subject}
- 学习目标：${options.goal}
- 日期范围：${options.startDate} 至 ${options.endDate}
- 可用时段：${options.timeSlots}
- 其他限制：${options.constraints || '无'}

必须严格符合此结构：
{
  "version": 1,
  "title": "课表标题",
  "timezone": "Asia/Shanghai",
  "audience": "大学一年级",
  "subject": "数学",
  "lessons": [
    {
      "date": "YYYY-MM-DD",
      "weekday": "周一",
      "startTime": "HH:mm",
      "durationMinutes": 60,
      "course": "课程名称",
      "topic": "本次具体知识点",
      "tasks": ["明确且可验收的学习任务", "练习数量或输出要求"],
      "resources": [{"title": "资源名称", "url": "https://...", "type": "document或video或practice"}]
    }
  ]
}

要求：日期与星期必须一致；只在可用时段排课；内容由浅入深；每次任务能在一次学习时段完成。优先提供中文、免费、信息密度高、来源可靠的资源；不确定具体深层链接时可省略该资源，不要编造 URL。`;
}

function extractJson(content) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('AI 未返回可解析的 JSON');
  }
}

async function requestChat(config, messages, temperature = 0.2) {
  const endpoint = endpointFor(config.baseUrl);
  if (!config.apiKey) throw new Error('请输入 API Key');
  if (!config.model) throw new Error('请输入模型名称');
  const body = {
    model: config.model,
    messages,
    temperature,
    response_format: { type: 'json_object' },
  };
  let response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok && [400, 422].includes(response.status)) {
    delete body.response_format;
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`API 请求失败（${response.status}）：${detail}`);
  }
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('API 响应中缺少 choices[0].message.content');
  return extractJson(content);
}

async function loadTimetableSource(filePath) {
  if (fs.statSync(filePath).size > 20 * 1024 * 1024) throw new Error('课表文件不能超过 20 MB');
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.pdf') return pdfToImages(filePath, 4);
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const mimeType = mimeTypes[extension];
  if (!mimeType) throw new Error('请选择 PNG、JPG、WEBP 或 PDF 课表');
  const data = fs.readFileSync(filePath).toString('base64');
  return { images: [`data:${mimeType};base64,${data}`], pageCount: 1, totalPages: 1 };
}

async function analyzeTimetable(config) {
  if (!selectedTimetable) throw new Error('请先选择图片或 PDF 课表');
  const content = [
    {
      type: 'text',
      text: `识别课表中的所有固定课程或不可用时间，只输出 JSON：{"occupiedSlots":[{"weekday":"周一","startTime":"08:00","endTime":"09:50","title":"课程名"}]}。时间使用 HH:mm；忽略空白格；同一课程多次出现要逐条输出。`,
    },
    ...selectedTimetable.images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
  ];
  const result = await requestChat(config, [
    { role: 'system', content: '你是课表视觉识别器，只输出严格 JSON。' },
    { role: 'user', content },
  ], 0);
  const occupiedSlots = Array.isArray(result.occupiedSlots)
    ? result.occupiedSlots.filter((slot) => /周[一二三四五六日]/.test(slot.weekday || '') && /^\d{2}:\d{2}$/.test(slot.startTime || '') && /^\d{2}:\d{2}$/.test(slot.endTime || ''))
    : [];
  if (!occupiedSlots.length) throw new Error('视觉模型未识别到有效的已占用时段');
  return occupiedSlots;
}

async function callProvider(config, options) {
  const conflictText = options.occupiedSlots?.length
    ? `\n必须避开以下固定课程/不可用时段，不得有任何重叠：\n${JSON.stringify(options.occupiedSlots, null, 2)}`
    : '';
  const parsed = await requestChat(config, [
      { role: 'system', content: '只输出符合用户指定结构的 JSON。不要输出解释或代码围栏。' },
      { role: 'user', content: `${buildPrompt(options)}${conflictText}` },
    ]);
  const schedule = enrichResources(validateSchedule(parsed));
  const conflicts = findConflicts(schedule, options.occupiedSlots);
  if (conflicts.length) {
    throw new Error(`生成结果仍有 ${conflicts.length} 处时间冲突，请重新生成：${conflicts[0].lesson}`);
  }
  return schedule;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#f5f7f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('providers:get', () => providerDefaults);
ipcMain.handle('timetable:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择现有课表图片或 PDF',
    properties: ['openFile'],
    filters: [{ name: '课表图片或 PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    const source = await loadTimetableSource(result.filePaths[0]);
    selectedTimetable = { ...source, filePath: result.filePaths[0] };
    return {
      canceled: false,
      name: path.basename(result.filePaths[0]),
      pageCount: source.pageCount,
      totalPages: source.totalPages,
    };
  } catch (error) {
    return { canceled: false, error: error.message };
  }
});
ipcMain.handle('timetable:analyze', async (_, config) => {
  try {
    return { ok: true, occupiedSlots: await analyzeTimetable(config) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('schedule:generate', async (_, payload) => {
  try {
    const schedule = await callProvider(payload.config, payload.options);
    return { ok: true, schedule, markdown: toMarkdown(schedule) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('schedule:save', async (_, markdown, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 Markdown 课表',
    defaultPath: `${suggestedName || 'AI学习课表'}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, markdown, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

app.whenReady().then(() => {
  if (process.argv.includes('--smoke-test')) {
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
