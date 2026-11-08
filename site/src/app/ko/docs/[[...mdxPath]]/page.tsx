import {
  DocsPage,
  docsMetadata,
  docsStaticParams,
  type DocsPageProps
} from "../../../../components/docs-page";

export const dynamicParams = false;
export const generateStaticParams = () => docsStaticParams("ko");
export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata("ko", props);

export default function Page(props: DocsPageProps) {
  return <DocsPage {...props} locale="ko" />;
}
