import { createStore } from "solid-js/store";
import { MessageV2 } from "../types/opencode";

// 与 opencode desktop 完全一致的存储结构
export const [messageStore, setMessageStore] = createStore<{
  message: {
    [sessionID: string]: MessageV2.Info[];  // 按 sessionID 分组，数组按 id 排序
  };
  part: {
    [messageID: string]: MessageV2.Part[];  // 按 messageID 分组，数组按 id 排序
  };
}>({
  message: {},
  part: {},
});
