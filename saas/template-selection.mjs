const recovery = 'Choose a supported template from the gallery, or use “Choose for me.”';

function templateName(template, id) {
  return typeof template?.name === "string" && template.name.trim()
    ? template.name
    : id;
}

export function templateCompatibilityLabel(template) {
  if (template?.cloudCompatible === true)
    return template.description ||
      (template.connected || template.overflow
        ? "Connected device layout"
        : "Editable campaign layout");
  if (template?.cloudCompatible !== false)
    return "Compatibility information unavailable";
  const codes = new Set(
    Array.isArray(template.cloudLimitations)
      ? template.cloudLimitations.map((limitation) => limitation?.code)
      : [],
  );
  const reasons = [
    ...(codes.has("DEVICE_3D") ? ["3D devices"] : []),
    ...(codes.has("LAYERED_PHOTO") ? ["Layered photos"] : []),
  ];
  return ["Local editor only", ...reasons].join(" · ");
}

// Preserve the saved choice. Only a confirmed catalog flag admits explicit use.
export function assessTemplateSelection(values, catalog = []) {
  const id = typeof values?.templateId === "string" ? values.templateId : "";
  const mode = values?.templateMode;
  const template = Array.isArray(catalog)
    ? catalog.find((item) => item?.id === id)
    : undefined;
  const name = templateName(template, id);
  if (mode === "auto")
    return {
      allowed: true,
      code: "AUTO",
      templateId: null,
      message: `AppScreen will choose a supported template for your screenshots.${id ? ` Your saved choice “${name}” is retained for Use exactly or As inspiration.` : ""}`,
    };
  if (!["exact", "inspiration"].includes(mode))
    return {
      allowed: false,
      code: "INVALID_MODE",
      message: "Choose how AppScreen should use the template before starting.",
    };
  if (!id)
    return { allowed: false, code: "MISSING_TEMPLATE", message: recovery };
  if (!template)
    return {
      allowed: false,
      code: "UNKNOWN_TEMPLATE",
      message: `Your saved template “${id}” is unavailable in this catalog. Refresh the catalog to check again. ${recovery}`,
    };
  if (template.cloudCompatible === false) {
    const reasons = Array.isArray(template.cloudLimitations)
      ? [...new Set(template.cloudLimitations
        .map((limitation) => limitation?.message)
        .filter((message) => typeof message === "string" && message.trim()))]
        .join(" ")
      : "";
    return {
      allowed: false,
      code: "LOCAL_ONLY",
      message: `“${name}” is available only in the local editor.${reasons ? ` ${reasons}` : ""} ${recovery}`,
    };
  }
  if (template.cloudCompatible !== true)
    return {
      allowed: false,
      code: "COMPATIBILITY_UNAVAILABLE",
      message: `Compatibility information for “${name}” is unavailable. Refresh the catalog to check again. ${recovery}`,
    };
  return {
    allowed: true,
    code: "SUPPORTED",
    templateId: id,
    message: `${name} selected. ${mode === "exact" ? "Keep the layout and device positions; adapt content to fit." : "AppScreen can adapt the composition while following this direction."}`,
  };
}
