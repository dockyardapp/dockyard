/**
 * Inline line-icon set. Stroke-based, 16px default, currentColor.
 * No emoji anywhere in UI chrome (template icons are data and rendered as text).
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'dashboard'
  | 'container'
  | 'template'
  | 'stack'
  | 'tunnel'
  | 'image'
  | 'volume'
  | 'network'
  | 'audit'
  | 'settings'
  | 'search'
  | 'refresh'
  | 'plus'
  | 'play'
  | 'stop'
  | 'restart'
  | 'pause'
  | 'trash'
  | 'copy'
  | 'check'
  | 'close'
  | 'menu'
  | 'chevron-right'
  | 'chevron-down'
  | 'warning'
  | 'terminal'
  | 'activity'
  | 'file'
  | 'external'
  | 'download'
  | 'logout'
  | 'user'
  | 'shield'
  | 'link'
  | 'info';

const PATHS: Record<IconName, string> = {
  dashboard: 'M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 14h7v7H3z',
  container: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  template: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  stack: 'M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  tunnel: 'M9 15a3 3 0 106 0 3 3 0 00-6 0zM4 20a8 8 0 0116 0',
  image: 'M4 4h16v16H4zM4 15l4-4 5 5M14 13l2-2 4 4M9 9a1.4 1.4 0 11-2.8 0A1.4 1.4 0 019 9z',
  volume: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  network: 'M12 3v4M12 17v4M5 12H3M21 12h-2M7 8h10v8H7z',
  audit: 'M5 3h11l3 3v15H5zM8 9h8M8 13h8M8 17h5',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h8M16 18h4M14 6a2 2 0 104 0 2 2 0 00-4 0zM8 12a2 2 0 104 0 2 2 0 00-4 0zM12 18a2 2 0 104 0 2 2 0 00-4 0z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  refresh: 'M20 11a8 8 0 10-1.5 5M20 4v7h-7',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  restart: 'M4 12a8 8 0 1015-3.5M20 4v6h-6',
  pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM4 15V4h11v3',
  check: 'M4 12l5 5L20 6',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M3 6h18M3 12h18M3 18h18',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  warning: 'M12 3l9 16H3zM12 10v4M12 17h.01',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
  activity: 'M3 12h4l2 6 4-14 2 8h6',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6',
  external: 'M14 4h6v6M20 4l-8 8M18 14v5H5V6h5',
  download: 'M12 4v10M8 11l4 4 4-4M5 20h14',
  logout: 'M15 4h4v16h-4M4 12h11M11 8l4 4-4 4',
  user: 'M12 4a4 4 0 100 8 4 4 0 000-8zM5 21a7 7 0 0114 0',
  shield: 'M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7L11.5 7M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7L12.5 17',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7h.01',
};

type Props = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 16, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The Dockyard mark: a simple container-crate glyph, no external asset. */
export function BrandMark({ size = 22, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </svg>
  );
}
