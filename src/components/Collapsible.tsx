import { createSignal, createUniqueId, ParentProps, Show, createContext, useContext } from "solid-js";

export interface CollapsibleProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  class?: string;
  defaultOpen?: boolean;
}

function CollapsibleRoot(props: ParentProps<CollapsibleProps>) {
  const [internalOpen, setInternalOpen] = createSignal(props.defaultOpen ?? false);
  const id = createUniqueId();
  const triggerId = `collapsible-${id}-trigger`;
  const contentId = `collapsible-${id}-content`;

  const isOpen = () => props.open ?? internalOpen();
  
  const handleToggle = () => {
    const newState = !isOpen();
    setInternalOpen(newState);
    props.onOpenChange?.(newState);
  };

  return (
    <div 
      data-component="collapsible"
      data-open={isOpen() ? "" : undefined}
      class={props.class}
    >
      <CollapsibleContext.Provider value={{ isOpen, handleToggle, triggerId, contentId }}>
        {props.children}
      </CollapsibleContext.Provider>
    </div>
  );
}

interface CollapsibleContextType {
  isOpen: () => boolean;
  handleToggle: () => void;
  triggerId: string;
  contentId: string;
}

const CollapsibleContext = createContext<CollapsibleContextType>();

function useCollapsible() {
  const ctx = useContext(CollapsibleContext);
  if (!ctx) {
    throw new Error("Collapsible components must be used within a Collapsible");
  }
  return ctx;
}

// Trigger component
interface CollapsibleTriggerProps extends ParentProps {
  class?: string;
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
}

function CollapsibleTrigger(props: CollapsibleTriggerProps) {
  const { isOpen, handleToggle, triggerId, contentId } = useCollapsible();
  
  return (
    <button
      type="button"
      id={triggerId}
      data-slot="collapsible-trigger"
      class={props.class}
      disabled={props.disabled}
      aria-label={props["aria-label"]}
      aria-expanded={isOpen()}
      aria-controls={contentId}
      title={props.title}
      onClick={handleToggle}
    >
      {props.children}
    </button>
  );
}

// Content component
interface CollapsibleContentProps extends ParentProps {
  class?: string;
}

function CollapsibleContent(props: CollapsibleContentProps) {
  const { isOpen, triggerId, contentId } = useCollapsible();
  
  return (
    <div
      id={contentId}
      role="group"
      aria-labelledby={triggerId}
      data-slot="collapsible-content"
      class={props.class}
      hidden={!isOpen()}
      style={{ display: isOpen() ? undefined : "none" }}
    >
      <Show when={isOpen()}>{props.children}</Show>
    </div>
  );
}

// Arrow component
interface CollapsibleArrowProps {
  class?: string;
}

function CollapsibleArrow(props: CollapsibleArrowProps) {
  const { isOpen } = useCollapsible();
  
  return (
    <div 
      data-slot="collapsible-arrow" 
      class={props.class}
      aria-hidden="true"
      style={{
        transform: isOpen() ? "rotate(180deg)" : "rotate(0deg)",
      }}
    >
      <svg 
        xmlns="http://www.w3.org/2000/svg" 
        width="14" 
        height="14" 
        viewBox="0 0 24 24" 
        fill="none" 
        stroke="currentColor" 
        stroke-width="2" 
        stroke-linecap="round" 
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6"/>
      </svg>
    </div>
  );
}

export const Collapsible = Object.assign(CollapsibleRoot, {
  Trigger: CollapsibleTrigger,
  Content: CollapsibleContent,
  Arrow: CollapsibleArrow,
});
