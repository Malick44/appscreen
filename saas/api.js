import { getAccessToken } from "./session.js";

export class ApiError extends Error {
  constructor(message, code, status, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function api(
  path,
  {
    method = "GET",
    body,
    authenticated = true,
    timeout = 45000,
    signal,
    responseType = "json",
  } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const headers = {
      Accept:
        responseType === "download"
          ? "application/zip, application/json"
          : "application/json",
    };
    if (authenticated) {
      const token = await getAccessToken();
      if (!token)
        throw new ApiError(
          "Sign in to continue. Your project is still saved.",
          "SIGN_IN_REQUIRED",
          401,
        );
      headers.Authorization = `Bearer ${token}`;
    }
    const isForm = body instanceof FormData;
    if (body && !isForm) headers["Content-Type"] = "application/json";
    const response = await fetch(path, {
      method,
      headers,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
      credentials: "same-origin",
    });
    const type = response.headers.get("content-type") || "";
    const result = type.includes("application/json")
      ? await response.json()
      : null;
    if (!response.ok)
      throw new ApiError(
        result?.error?.message ||
          `The request could not finish (${response.status}). Please try again.`,
        result?.error?.code || "REQUEST_FAILED",
        response.status,
        result?.error?.details,
      );
    if (responseType === "download") {
      if (!/^application\/zip(?:;|$)/i.test(type))
        throw new ApiError(
          "The server did not return a workspace ZIP. No archive was downloaded.",
          "INVALID_DOWNLOAD",
          response.status,
        );
      return {
        blob: await response.blob(),
        contentType: type,
        contentLength: response.headers.get("content-length"),
        contentEncoding: response.headers.get("content-encoding"),
        contentDisposition: response.headers.get("content-disposition") || "",
      };
    }
    if (!result)
      throw new ApiError(
        "The server did not return the expected response. Check that the AppScreen backend is running.",
        "INVALID_RESPONSE",
        response.status,
      );
    return result;
  } catch (error) {
    if (error.name === "AbortError")
      throw new ApiError(
        responseType === "download"
          ? "The export download was interrupted or took too long. No complete archive was received. Try again."
          : "This request took too long. Your work may still be running; refresh its status before trying again.",
        "REQUEST_TIMEOUT",
        0,
      );
    if (error instanceof TypeError)
      throw new ApiError(
        responseType === "download"
          ? "The export download lost its connection. No complete archive was received. Try again."
          : "AppScreen could not connect. Check your connection and try again.",
        "CONNECTION_FAILED",
        0,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
