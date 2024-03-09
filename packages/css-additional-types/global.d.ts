// https://github.com/frenic/csstype/blob/master/typings/mdn-data.d.ts

declare namespace MDN {
  interface Property {
    syntax: string;
    media: string;
    inherited: boolean;
    animationType: string;
    percentages: string;
    groups: string[];
    initial: string;
    appliesto: string;
    computed: string | string[];
    order: string;
    status: string;
    mdn_url?: string;
  }

  interface Properties {
    [property: string]: Property;
  }
}

declare module "mdn-data/css/properties.json" {
  const properties: MDN.Properties;
  export default properties;
}
