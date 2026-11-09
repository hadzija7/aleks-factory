import Link from "next/link";
import { ProjectList } from "@/components/project-list";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Aleks Factory</h1>
          <p className="text-sm opacity-60">Create a project, then hand its tasks to Mozaik agents.</p>
        </div>
        <Link href="/settings" className="rounded-md border border-black/10 px-3 py-1.5 text-sm hover:border-black/25 dark:border-white/15 dark:hover:border-white/30">
          Factory settings
        </Link>
      </header>
      <ProjectList />
    </main>
  );
}
