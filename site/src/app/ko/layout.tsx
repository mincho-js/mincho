import type { ReactNode } from "react";
import { SiteLayout, siteMetadata } from "../../components/site-layout";

export const generateMetadata = () => siteMetadata("ko");

export default function KoreanLayout({ children }: { children: ReactNode }) {
  return <SiteLayout locale="ko">{children}</SiteLayout>;
}
