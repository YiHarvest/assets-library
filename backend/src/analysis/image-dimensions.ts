export function displayDimensions(width: number, height: number, orientation?: number) {
  return orientation !== undefined && [5, 6, 7, 8].includes(orientation)
    ? { width: height, height: width }
    : { width, height };
}
