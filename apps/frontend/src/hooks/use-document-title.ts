import { useEffect } from "react";
import { PRODUCT_TITLE } from "@/lib/labels";

export function useDocumentTitle(page?: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${PRODUCT_TITLE}` : PRODUCT_TITLE;
  }, [page]);
}
