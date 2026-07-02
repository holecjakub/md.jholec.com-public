import type { Metadata } from "next";
import { DocumentExperience } from "./DocumentExperience";

export const metadata: Metadata = {
  title: "Document — md.jholec.com",
};

// Server Component. The doc fetch + gate/render are client-driven (the access
// token lives only in the URL fragment, which is unavailable on the server),
// so we just resolve the async route param and hand off to the client.
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <DocumentExperience slug={slug} />;
}
