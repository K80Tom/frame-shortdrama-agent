import { ToolRegistry } from '../kernel/tool-registry';
import { PRODUCTION_TOOL_DEFINITIONS, type ProductionToolExecutor } from './catalog';

/**
 * 把 19 个生产 Tool 注册进版本化 Registry。
 *
 * Adapter 只持有一个执行端口；数据库、模型密钥、对象存储与付费主权全部由
 * main 注入的 ProductionToolExecutor 实现，agent 侧不越界。
 */
export function createProductionToolRegistry(executor: ProductionToolExecutor): ToolRegistry {
  const registry = new ToolRegistry();
  for (const definition of PRODUCTION_TOOL_DEFINITIONS) {
    registry.register(definition, {
      execute: async (args, context) => executor.execute(definition.toolId, args as Record<string, unknown>, context),
    });
  }
  return registry;
}

/** 在既有 Registry 上追加生产工具，不覆盖已注册的同名版本。 */
export function attachProductionTools(registry: ToolRegistry, executor: ProductionToolExecutor): ToolRegistry {
  for (const definition of PRODUCTION_TOOL_DEFINITIONS) {
    registry.register(definition, {
      execute: async (args, context) => executor.execute(definition.toolId, args as Record<string, unknown>, context),
    });
  }
  return registry;
}
