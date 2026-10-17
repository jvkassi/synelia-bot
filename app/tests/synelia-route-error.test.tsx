import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { RouteError } from "@/components/layout/route-error";
import { ui } from "@/lib/i18n";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("route error page: French message, detail hidden until « Afficher le détail »", () => {
  const view = render(
    <RouteError error={new Error("boom: x is undefined")} reset={() => {}} />,
  );
  expect(view.getByRole("alert").textContent).toContain(
    "Une erreur est survenue. Rechargez la page.",
  );
  expect(view.queryByText("boom: x is undefined")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: ui.routeError.showDetail }));
  expect(view.getByText("boom: x is undefined")).toBeTruthy();
  expect(
    view.getByRole("button", { name: ui.routeError.hideDetail }),
  ).toBeTruthy();
  expect(view.container.textContent).not.toMatch(
    /Something went wrong|Show Error/,
  );
});
