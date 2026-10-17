import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { MemoryList, RememberFact } from "@/components/memory/memories";
import { ui } from "@/lib/i18n";

export const Route = createFileRoute("/_authed/settings/memory")({
  component: MemorySettingsPage,
});

function MemorySettingsPage() {
  return (
    <PageShell
      action={<RememberFact />}
      description={ui.settings.memory.description}
      title={ui.settings.memory.title}
    >
      <MemoryList />
    </PageShell>
  );
}
