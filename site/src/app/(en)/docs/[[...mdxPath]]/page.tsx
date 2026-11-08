import {
  DocsPage,
  docsMetadata,
  docsStaticParams,
  type DocsPageProps
} from "../../../../components/docs-page";

export const dynamicParams = false;
export const generateStaticParams = () => docsStaticParams("en");
export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata("en", props);

export default function Page(props: DocsPageProps) {
  return <DocsPage {...props} locale="en" />;
}
