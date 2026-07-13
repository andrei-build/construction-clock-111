import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export function IconDashboard(props: IconProps) {
  return (
    <Icon {...props}>
      <line x1="6" y1="20" x2="6" y2="12" />
      <line x1="12" y1="20" x2="12" y2="5" />
      <line x1="18" y1="20" x2="18" y2="14" />
    </Icon>
  )
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </Icon>
  )
}

export function IconTarget(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="1.5" />
    </Icon>
  )
}

export function IconChat(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12Z" />
    </Icon>
  )
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </Icon>
  )
}

export function IconUsers(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 5.5a3 3 0 0 1 0 5" />
      <path d="M17 14.5a6 6 0 0 1 4 5.5" />
    </Icon>
  )
}

export function IconDispatch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
      <path d="M13 9l3 3-3 3" />
    </Icon>
  )
}

export function IconCalendar(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 9h16" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </Icon>
  )
}

export function IconMap(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
      <path d="M9 4v14" />
      <path d="M15 6v14" />
    </Icon>
  )
}

export function IconMoney(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 12h.01M18 12h.01" />
    </Icon>
  )
}

export function IconWallet(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H5a2 2 0 0 1 0-4h12v3" />
      <circle cx="16.5" cy="13" r="1.2" />
    </Icon>
  )
}

export function IconChart(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4v16h16" />
      <path d="M7 15l3-4 3 2 4-6" />
    </Icon>
  )
}

export function IconBriefcase(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </Icon>
  )
}

export function IconImage(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m4 17 4.5-4.5 3 3L15 12l5 5" />
    </Icon>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </Icon>
  )
}
