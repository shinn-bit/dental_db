import { type Message } from "@aws-sdk/client-bedrock-runtime";

// 画面から送られる直近の会話（今回の質問は含まない）
export type ChatHistoryItem = { role: "user" | "assistant"; text: string };

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 2000;

// Converse は user から始まり user/assistant が交互である必要がある
export function buildHistoryMessages(history: ChatHistoryItem[] | undefined): Message[] {
  const messages: Message[] = [];
  for (const item of (history ?? []).slice(-MAX_HISTORY_MESSAGES)) {
    const text = item.text?.trim().slice(0, MAX_HISTORY_CHARS);
    if (!text || (item.role !== "user" && item.role !== "assistant")) continue;
    if (messages.length === 0 && item.role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === item.role) {
      last.content = [{ text: `${last.content?.[0]?.text ?? ""}\n\n${text}` }];
    } else {
      messages.push({ role: item.role, content: [{ text }] });
    }
  }
  // 最後は assistant で終える（直後に今回の user 質問を足すため）
  if (messages.length > 0 && messages[messages.length - 1].role === "user") messages.pop();
  return messages;
}
