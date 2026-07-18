export interface ScreenPoint {
  x: number;
  y: number;
}

export function isOutsideRect(
  point: ScreenPoint,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
): boolean {
  return point.x < rect.left || point.x > rect.right || point.y < rect.top || point.y > rect.bottom;
}

export function centeredDropPosition(
  point: ScreenPoint,
  size: { width: number; height: number },
): ScreenPoint {
  return {
    x: point.x - size.width / 2,
    y: point.y - size.height / 2,
  };
}
