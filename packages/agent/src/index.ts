/**
 * Lyra 智能能力层入口。
 *
 * 边界：这里只有决策、编排与状态机——不连接数据库、不读取模型密钥、不监听端口。
 * 需要真实数据时通过 AssistantTool / AssistantRepository 等接口获取，由 main 注入实现。
 */
export * from './assistant/contracts';
export * from './assistant/tools';
export * from './assistant/orchestrator';
export * from './assistant/service';
export * from './assistant/repository';
export * from './prompt-library/index';
export * from './novel/screenplay';
