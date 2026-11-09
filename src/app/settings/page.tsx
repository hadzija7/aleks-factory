import Link from "next/link";
import { FactorySettings } from "@/components/factory-settings";

export const metadata = { title: "Factory settings · Aleks Factory" };

export default function SettingsPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <header>
        <Link href="/" className="text-xs opacity-60 hover:opacity-100">
          ← Projects
        </Link>
        <h1 className="text-2xl font-semibold">Factory settings</h1>
        <p className="text-sm opacity-60">Models the factory&apos;s agents run on.</p>
      </header>
      <FactorySettings />
    </main>
  );
}
