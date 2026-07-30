export function displayModel(model: string | undefined): string {
  return model ?? "default";
}

export function modelTag(model: string | undefined): string {
  return `[${displayModel(model)}]`;
}
