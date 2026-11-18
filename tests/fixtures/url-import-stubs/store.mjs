// 测试替身：store 负责「事务 + 状态」，本层只关心拒绝时机，替换成直通实现。
export const replaceHistory = async (run) => await run()

export const useChatStore = {
  getState: () => ({ sessions: [], sessionCache: {} }),
}
