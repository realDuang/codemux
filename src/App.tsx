import { Router, Route } from "@solidjs/router";
import { createEffect } from "solid-js";
import { Auth } from "./lib/auth";
import Login from "./pages/Login";
import Chat from "./pages/Chat";
import RemoteAccess from "./pages/RemoteAccess";
import Settings from "./pages/Settings";

function App() {
  console.log("🎨 App component rendering");
  console.log("🔐 Is authenticated:", Auth.isAuthenticated());

  return (
    <Router>
      <Route path="/login" component={Login} />
      <Route path="/remote" component={RemoteAccess} />
      <Route path="/settings" component={Settings} />
      <Route
        path="/chat"
        component={() => {
          createEffect(() => {
            if (!Auth.isAuthenticated()) {
              console.log("❌ Not authenticated, redirecting to login");
              window.location.href = "/login";
            } else {
              console.log("✅ Authenticated, showing chat");
            }
          });
          return <Chat />;
        }}
      />
      <Route
        path="/"
        component={() => {
          createEffect(() => {
            if (!Auth.isAuthenticated()) {
              console.log("❌ Not authenticated, redirecting to login");
              window.location.href = "/login";
            } else {
              console.log("✅ Authenticated, redirecting to chat");
              window.location.href = "/chat";
            }
          });
          return <Chat />;
        }}
      />
    </Router>
  );
}

export default App;
