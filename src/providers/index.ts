import { FredProvider } from "./fred";
import { ManualProvider } from "./manual";
import { TushareProvider } from "./tushare";
import { TwelveDataProvider } from "./twelve-data";

export function createProviderRegistry() {
  return [new ManualProvider(), new TushareProvider(), new FredProvider(), new TwelveDataProvider()];
}
