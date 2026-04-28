'use client'

import {
  Editor,
  type SidebarTab,
  ViewerToolbarLeft,
  ViewerToolbarRight,
} from '@pascal-app/editor'
import { useSeedDefaultMetadata } from '../bimai/lib/seed'
import { BIMPropertiesPanel } from '../bimai/panels/bim-properties-panel'
import { CostPanel } from '../bimai/panels/cost-panel'
import { GenerationPanel } from '../bimai/panels/generation-panel'
import { OptimizerPanel } from '../bimai/panels/optimizer-panel'
import { ProgramPanel } from '../bimai/panels/program-panel'
import { ProjectPanel } from '../bimai/panels/project-panel'
import { SchedulePanel } from '../bimai/panels/schedule-panel'
import { ZoningPanel } from '../bimai/panels/zoning-panel'
import { EnvelopeRenderer } from '../bimai/viewer/buildable-envelope/envelope-renderer'

const SIDEBAR_TABS: (SidebarTab & { component: React.ComponentType })[] = [
  {
    id: 'site',
    label: 'Scene',
    component: () => null, // Built-in SitePanel handles this
  },
  { id: 'project', label: 'Project', component: ProjectPanel },
  { id: 'zoning', label: 'Zoning', component: ZoningPanel },
  { id: 'program', label: 'Program', component: ProgramPanel },
  { id: 'generation', label: 'Generate', component: GenerationPanel },
  { id: 'optimizer', label: 'Optimizer', component: OptimizerPanel },
  { id: 'schedule', label: 'Schedule', component: SchedulePanel },
  { id: 'cost', label: 'Cost', component: CostPanel },
  { id: 'bim', label: 'BIM', component: BIMPropertiesPanel },
]

export default function Home() {
  useSeedDefaultMetadata()
  return (
    <div className="h-screen w-screen">
      <Editor
        layoutVersion="v2"
        projectId="local-editor"
        sidebarTabs={SIDEBAR_TABS}
        viewerToolbarLeft={<ViewerToolbarLeft />}
        viewerToolbarRight={<ViewerToolbarRight />}
        viewerSceneSlot={<EnvelopeRenderer />}
      />
    </div>
  )
}
