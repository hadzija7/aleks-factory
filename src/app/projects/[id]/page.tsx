import { Suspense } from "react";
import { ProjectView } from "@/components/project-view";

async function Project({ params }: { params: PageProps<"/projects/[id]">["params"] }) {
  const { id } = await params;
  return <ProjectView projectId={id} />;
}

export default function ProjectPage(props: PageProps<"/projects/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-1 flex-col gap-6 p-6">
      <Suspense fallback={<p className="text-sm opacity-60">Loading…</p>}>
        <Project params={props.params} />
      </Suspense>
    </main>
  );
}
