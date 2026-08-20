/** Shared task prompts for CLI and current-profile Web workflow launches. */
export function buildTaskPrompt(topic?: string): string {
  const topicText = typeof topic === 'string' && topic.trim() !== ''
    ? `主题：${topic}`
    : '主题：当前 profile/配置中的学习主题与阶段'
  const topicArg = typeof topic === 'string' && topic.trim() !== ''
    ? `literature_push_now(topic=${JSON.stringify(topic.trim())})`
    : 'literature_push_now()'
  return (
    '执行文献精选推送工作流（Literature Agent）。' +
    topicText +
    '。\n' +
    '步骤：1) 调用 ' + topicArg + ' 获取工作流指令与 pushId（优先近5年高质量论文，允许里程碑经典；' +
    '先查历史避免重复推荐，遵循阅读阶段主线递进）。\n' +
    '2) 按 literature_push_now 返回的 instructions 逐步执行：检索→语义排序精选1篇→下载PDF→分块全文精读→' +
    '撰写结构化 Markdown 精读报告并归档到文献库→用 literature_record 提交结果。\n' +
    '2b) 性能要求：语义排序必须 BATCH（一次至多两次 LLM 调用评估全部 Top 15，禁止逐篇独立调用）；候选排序阶段目标 ≤ 2 分钟；' +
    'literature_record 时自报 llmCallCount/llmRetryCount/agentRankingMs/reportGenerationMs。\n' +
    '3) Human-in-the-loop（NEED_USER_ACTION）规则：遇到资源访问/认证/权限/下载渠道/研究选择问题且用户更容易解决时，' +
    '不要盲目重试、不要直接判定失败——用 literature_user_action(open) 注册待办（五要素：卡在哪步/缺什么/试过什么/用户做什么/如何继续），' +
    '再用 literature_record 提交 status=user_action_required（errorCode=AUTH_REQUIRED 等），并在汇报中完整展示五要素；' +
    '用户处理后可运行 --resume 恢复。禁止把 AUTH_REQUIRED / USER_RESOURCE_NEEDED 误记为 FULLTEXT_UNAVAILABLE。\n' +
    '4) 若全文不可得且不属于上述 HITL 场景（FULLTEXT_UNAVAILABLE），如实以 status=fulltext_unavailable 结束，禁止凭摘要伪装精读。\n' +
    '完成后用不超过 5 句话汇报：推送号、选中论文、报告路径、阶段进度（若为 NEED_USER_ACTION 则汇报五要素与恢复命令）。'
  )
}

export function buildResumePrompt(pushId: number): string {
  return (
    '恢复文献推送 workflow（Literature Agent）。pushId=' +
    pushId +
    '。\n' +
    '步骤：1) 调用 literature_resume(pushId=' +
    pushId +
    ') 获取卡点、待办与 resumeFrom 步骤。\n' +
    '2) 若返回 openActions（NEED_USER_ACTION 待办）：先明确展示五要素（卡在哪步/缺什么/试过什么/用户做什么/如何继续），' +
    '并说明「用户处理完成后重新运行 dsh-literature-push.mjs --resume ' +
    pushId +
    '」；若待办已解决（用户已处理），按其 howToContinue 继续。\n' +
    '3) 不要重新运行 literature_sources、不要重新评分——候选与评分已持久化；严格按 resumeFrom 指示的步骤继续' +
    '（fetch_pdf 可用 allowCarsi=true 或 manualPdfPath；fulltext_index → literature_fulltext_read 逐块精读 → 报告 → literature_record）。\n' +
    '完成后用不超过 5 句话汇报：恢复的步骤、最终状态、报告路径（或仍待用户处理的事项）。'
  )
}
