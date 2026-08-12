// card-utils.js — details.card 注入辅助
// wrapTool（非 self-managed 工具）与 exec_command/file（self-managed，
// 内部自行记录历史）共用：统一卡片 route 构造，避免三处重复。
// cardId 可为 op_xxx（startOperation）或 h_xxx（recordHistory），
// getHistory 两者都能查（opRef 关联）。

export function attachCard(result, { opId, label, summary }) {
  if (result && typeof result === "object" && opId) {
    result.details = {
      ...(result.details || {}),
      card: {
        route: `/card/op?opId=${opId}`,
        title: label || "operation",
        description: summary || label || "operation",
        aspectRatio: "16:1",
      },
    };
  }
  return result;
}
