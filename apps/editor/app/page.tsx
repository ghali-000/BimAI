'use client'

import {
  Editor,
  type SidebarTab,
  ViewerToolbarLeft,
  ViewerToolbarRight,
} from '@pascal-app/editor'
import { useSeedDefaultMetadata } from '../bimai/lib/seed'
import { ProgramPanel } from '../bimai/panels/program-panel'
import { ProjectPanel } from '../bimai/panels/project-panel'
import { ZoningPanel } from '../bimai/panels/zoning-panel'

const SIDEBAR_TABS: (SidebarTab & { component: React.ComponentType })[] = [
  {
    id: 'site',
    label: 'Scene',
    component: () => null, // Built-in SitePanel handles this
  },
  { id: 'project', label: 'Project', component: ProjectPanel },
  { id: 'zoning', label: 'Zoning', component: ZoningPanel },
  { id: 'program', label: 'Program', component: ProgramPanel },
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
      />
    </div>
  )
}
