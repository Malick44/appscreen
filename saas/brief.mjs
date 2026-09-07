export function defaultDraft(data) {
  const document = data.revision?.document || data.proposedRevision?.document;
  const brief = Object.keys(data.project.brief || {}).length
    ? data.project.brief
    : document?.brief || {};
  const preferences = data.project.designPreferences || {};
  return {
    appName: brief.appName ?? data.project.name ?? "",
    promise: brief.promise || "",
    audience: brief.audience || "",
    facts: (brief.confirmedFacts || []).join("\n") || brief.facts || "",
    style: brief.style || "elegant",
    brandColor: brief.brandColors?.[0] || brief.brandColor || "#b9b1ff",
    screenCount:
      preferences.screenCount ||
      Math.max(5, Math.min(8, document?.scenes?.length || 5)),
    templateMode:
      preferences.templateMode || document?.template?.mode || "auto",
    templateId: Object.hasOwn(preferences, "templateId")
      ? preferences.templateId || ""
      : document?.template?.id || "",
    locks: Object.entries(preferences.locks || document?.locks || {})
      .filter(([, locked]) => locked)
      .map(([key]) => key),
    sourceIds:
      preferences.sourceIds ||
      data.assets
        .filter(
          (asset) =>
            asset.kind === undefined ||
            ["source", "original", "screenshot"].includes(asset.kind),
        )
        .slice(0, 10)
        .map((asset) => asset.id),
    consent: false,
  };
}

export function briefPayload(values) {
  return {
    brief: {
      appName: values.appName,
      promise: values.promise,
      audience: values.audience,
      confirmedFacts: values.facts
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      style: values.style,
      brandColors: [values.brandColor],
    },
    designPreferences: {
      templateId: values.templateId || null,
      templateMode: values.templateMode,
      locks: Object.fromEntries(values.locks.map((key) => [key, true])),
      screenCount: values.screenCount,
      sourceIds: values.sourceIds,
      profile: { id: "iphone-6.9", width: 1320, height: 2868 },
      locale: "en",
    },
  };
}
