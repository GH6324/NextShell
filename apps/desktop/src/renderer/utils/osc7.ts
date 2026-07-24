const normalizePosixPath = (rawPath: string): string | undefined => {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const normalized = trimmed.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
};

export const parseOsc7Path = (payload: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return undefined;
  }

  if (url.protocol !== "file:") {
    return undefined;
  }

  try {
    return normalizePosixPath(decodeURIComponent(url.pathname));
  } catch {
    return undefined;
  }
};
