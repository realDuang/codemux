import { Router, Route } from "@solidjs/router";
import { createEffect } from "solid-js";
import { Auth } from "./lib/auth";
import { I18nProvider } from "./lib/i18n";
import { logger } from "./lib/logger";
import EntryPage from "./pages/EntryPage";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import RemoteAccess from "./pages/RemoteAccess";
import Settings from "./pages/Settings";
import Devices from "./pages/Devices";

function App() {
  logger.debug("🎨 App component rendering");
  logger.debug("🔐 Is authenticated:", Auth.isAuthenticated());

  return (
    <I18nProvider>
      <Router>
        <Route path="/" component={EntryPage} />
        <Route path="/login" component={Login} />
        <Route path="/remote" component={RemoteAccess} />
        <Route path="/settings" component={Settings} />
        <Route path="/devices" component={Devices} />
        <Route
          path="/chat"
          component={() => {
            createEffect(() => {
              if (!Auth.isAuthenticated()) {
                logger.debug("❌ Not authenticated, redirecting to entry");
                window.location.href = "/";
              } else {
                logger.debug("✅ Authenticated, showing chat");
              }
            });
            return <Chat />;
          }}
        />
      </Router>
    </I18nProvider>
  );
}

export default App;
