# AI Schedule Generator / AI 课表生成器

> 项目动机：由于大部分国内大学的课纯水，大学生又不够自律与有规划，因此生成此项目。

一款 Windows Electron 桌面应用。用户自行提供 OpenAI 兼容服务商、API 地址、API Key 和模型，选择年级、学科、日期与可用时段后，应用要求模型生成固定 JSON，完成本地校验、资源补全和冲突检查，最后导出可供 [course-reminder](https://github.com/VibrateZ/course-reminder) 使用的 Markdown 课表。

## 功能

- 预设 OpenAI、DeepSeek、Kimi、硅基流动，并支持自定义 OpenAI 兼容接口。
- API Key 只保存在当前窗口内，不写入磁盘。
- 固定 JSON 结构生成并本地校验日期、时间、课程内容和资源 URL。
- 数学主题补充中国大学 MOOC 主课，并为每节课附带 B 站与必应检索入口。
- 选择 PNG、JPG、WEBP 或 PDF 课表，调用视觉模型识别固定课程。
- PDF 在本机最多渲染前 4 页为图片，再发送到用户指定的视觉模型。
- 将识别出的占用时段加入生成约束，并在导出前进行确定性的时间重叠检查。
- 一键导出与“课程提醒”兼容的 Markdown。

## 模型要求

服务商需要提供 OpenAI 兼容的 `/chat/completions` 接口。生成普通课表只需文本模型；识别图片/PDF 课表时，所选模型必须支持 `image_url` 多模态输入。

## JSON 格式

```json
{
  "version": 1,
  "title": "大一数学学习计划",
  "timezone": "Asia/Shanghai",
  "audience": "大学一年级",
  "subject": "数学",
  "lessons": [
    {
      "date": "2026-09-21",
      "weekday": "周一",
      "startTime": "10:10",
      "durationMinutes": 60,
      "course": "微积分",
      "topic": "函数与极限",
      "tasks": ["完成 6 道基础题"],
      "resources": [{ "title": "课程", "url": "https://example.com", "type": "course" }]
    }
  ]
}
```

## 开发

```powershell
npm install
npm test
npm start
```

## 打包

```powershell
npm run package
```

便携版输出到 `release/ai-schedule-generator-0.1.0.exe`。
