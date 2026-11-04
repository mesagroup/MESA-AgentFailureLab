import { SearchX } from "lucide-react";
import { Link } from "react-router-dom";
import { Page } from "@/components/PageHeader";
import { StateCard } from "@/components/StateCard";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function NotFoundPage() {
  useDocumentTitle("Page not found");
  return (
    <Page>
      <StateCard
        icon={SearchX}
        title="This page does not exist"
        description="The address is not part of the lab."
        action={<Button size="sm" className="rounded-full" nativeButton={false} render={<Link to="/" />}>Go to Dashboard</Button>}
      />
    </Page>
  );
}
