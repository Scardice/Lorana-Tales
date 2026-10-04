/** Camera transforms compose instead of competing for a single CSS animation property. */
export function createScreenMotion(element: Element | null, effect: string, duration: number, repeat: number): Animation | null {
  if (!element || typeof element.animate !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const frames: Record<string, Keyframe[]> = {
    'shake-light': [{transform:'translateX(0)'},{transform:'translateX(-4px)'},{transform:'translateX(3px)'},{transform:'translateX(0)'}],
    'shake-heavy': [{transform:'translate(0,0)'},{transform:'translate(-8px,4px)'},{transform:'translate(7px,-3px)'},{transform:'translate(-4px,2px)'},{transform:'translate(0,0)'}],
    'zoom-focus': [{transform:'scale(1)'},{transform:'scale(1.045)',offset:.35},{transform:'scale(1)'}],
    chromatic: [{filter:'drop-shadow(0 0 transparent)'},{filter:'drop-shadow(-3px 0 #ff335599) drop-shadow(3px 0 #33aaff99)'},{filter:'drop-shadow(0 0 transparent)'}],
  };
  if (!frames[effect]) return null;
  return element.animate(frames[effect], {duration,iterations:repeat,easing:'ease-in-out',composite:'add'});
}
