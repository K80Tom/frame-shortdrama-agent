/**
 * Lyra 公共契约入口。
 *
 * shared 只包含类型、纯函数与错误定义：不连接数据库、不读取密钥、不发起网络请求。
 * main / agent / cli / web 都从这里取同一套语言，避免各包自定义合同。
 */
export * from './models';
export * from './production';
export * from './prompt-packs';
export * from './asset-retrieval';
export * from './evolution';
export * from './assets';
export * from './novel-analysis';
export * from './novel-domain';
export * from './novel-checkpoint';
export * from './novel-registry';
export * from './novel-adaptation';
