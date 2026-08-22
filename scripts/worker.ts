import "./refresh";

const sixHours = 6 * 60 * 60 * 1000;

setInterval(() => {
  import(`./refresh.ts?run=${Date.now()}`).catch((error) => {
    console.error("Scheduled refresh failed", error instanceof Error ? error.message : error);
  });
}, sixHours);

console.log("Local refresh worker started; interval: 6 hours.");
