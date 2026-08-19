const currentExecutionNarrationPatterns = [
  /^(?:i(?:'m| am)|we(?:'re| are))\s+(?:now\s+|currently\s+|just\s+)?(?:checking|inspecting|reading|running|executing|opening|building|testing|analy[sz]ing|replying|responding|writing|editing|modifying)\b/iu,
  /^(?:i|we)\s+(?:will\s+)?(?:now|first|next|just)\s+(?:check|inspect|read|run|execute|open|build|test|analy[sz]e|reply|respond|output|write|edit|modify|handle|fix)\b/iu,
  /^(?:i|we)\s+(?:have\s+)?just\s+(?:checked|inspected|read|ran|executed|opened|built|tested|analy[sz]ed|replied|responded|wrote|edited|modified|handled|fixed)\b/iu,
  /^(?:next|now|first),?\s+(?:i|we)\s+(?:will\s+)?(?:check|inspect|read|run|execute|open|build|test|analy[sz]e|reply|respond|output|write|edit|modify|handle|fix)\b/iu,
  /^(?:我|我们)(?:(?:现在|先|接下来|稍后|刚刚|刚才|刚|正在|等一下)){1,3}(?:会|将|要|再|正)?(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u,
  /^接下来我(?:会|将|要)(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u,
  /^(?:正在|刚刚|刚才|稍后)(?:检查|查看|读取|运行|执行|打开|构建|测试|分析|回复|输出|修改|处理|修复)/u,
] as const;

const recentOperationFailurePatterns = [
  /^(?:the\s+)?(?:command|tool(?:\s+call)?|test|build)\s+(?:has\s+)?just\s+(?:failed|errored)(?:\s+(?:because|due\s+to)\b.*)?[.!]?$/iu,
  /^(?:刚才|刚刚)(?:的)?(?:命令|工具调用|测试|构建).*(?:失败|报错|出错)[。！？]?$/u,
] as const;

const operationLocalCompletionPatterns = [
  /^(?:the\s+)?(?:command|tool\s+call|test)\s+(?:has\s+been\s+)?(?:completed|finished)[.!]?$/iu,
  /^(?:命令|工具调用|测试)(?:已经|已)(?:完成|结束)[。！？]?$/u,
] as const;

const currentInteractionScope =
  /(?:\b(?:this|the\s+current)\s+(?:command|tool\s+call|test|turn|response)\b|(?:本次|这次|当前|这一轮|这轮)(?:命令|工具调用|测试|对话|回复|响应))/iu;

/** Returns whether evidence describes only the current interaction or operation. */
export function isTransientExtractionEvidence(text: string): boolean {
  return (
    currentInteractionScope.test(text) ||
    currentExecutionNarrationPatterns.some((pattern) => pattern.test(text)) ||
    recentOperationFailurePatterns.some((pattern) => pattern.test(text)) ||
    operationLocalCompletionPatterns.some((pattern) => pattern.test(text))
  );
}
