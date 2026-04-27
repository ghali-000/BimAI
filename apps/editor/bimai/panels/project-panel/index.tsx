'use client'

import { useActiveSite } from '../../lib/active-nodes'
import { readSiteMetadata, writeSiteMetadata } from '../../lib/metadata'

export function ProjectPanel() {
  const site = useActiveSite()

  if (!site) {
    return (
      <div className="px-4 py-3 text-muted-foreground text-sm">
        No site loaded.
      </div>
    )
  }

  const meta = readSiteMetadata(site.id)
  const project = meta.project ?? {
    schemaVersion: 1 as const,
    name: 'Untitled Project',
    createdAt: '',
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      <div className="flex flex-col gap-1.5">
        <label
          className="font-medium text-muted-foreground text-xs"
          htmlFor="bimai-project-name"
        >
          Project name
        </label>
        <input
          className="h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          id="bimai-project-name"
          onChange={(e) =>
            writeSiteMetadata(site.id, {
              project: { ...project, name: e.target.value },
            })
          }
          type="text"
          value={project.name}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium text-muted-foreground text-xs">
          Created
        </span>
        <span className="text-sm">
          {project.createdAt
            ? new Date(project.createdAt).toLocaleString()
            : '—'}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-medium text-muted-foreground text-xs">
          Schema version
        </span>
        <span className="text-sm">{project.schemaVersion}</span>
      </div>
    </div>
  )
}
