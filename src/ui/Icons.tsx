import {
  AppWindow,
  ArrowUpDown,
  Brush,
  Check,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  FolderInput,
  FolderOutput,
  FolderPlus,
  LayoutGrid,
  Lock,
  Monitor,
  Palette,
  PencilLine,
  Plus,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  Trash2,
  Ungroup,
  type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  open: ExternalLink,
  rename: PencilLine,
  palette: Palette,
  sliders: SlidersHorizontal,
  ungroup: Ungroup,
  trash: Trash2,
  folderPlus: FolderPlus,
  folderIn: FolderInput,
  folderOut: FolderOutput,
  more: Ellipsis,
  plus: Plus,
  apps: AppWindow,
  sort: ArrowUpDown,
  grid: LayoutGrid,
  lock: Lock,
  refresh: RefreshCw,
  brush: Brush,
  monitor: Monitor,
  settings: Settings,
  check: Check,
  chevron: ChevronRight,
};

export function Icon({ name, size = 16 }: { name?: string; size?: number }) {
  if (!name) return null;
  const C = MAP[name];
  return C ? <C size={size} strokeWidth={1.8} /> : null;
}
