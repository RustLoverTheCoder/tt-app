import type { ReactElement } from "react";
import { requestMeasure, requestMutation } from "../fasterdom/fasterdom";

import { DEBUG, DEBUG_MORE } from "../../config";
import { throttleWith } from "../../util/schedulers";
import { orderBy } from "../../util/iteratees";
import { getUnequalProps } from "../../util/arePropsShallowEqual";
import { incrementOverlayCounter } from "../../util/debugOverlay";
import { isSignal } from "../../util/signals";
import safeExec from "../../util/safeExec";

export type Props = AnyLiteral;
export type FC<P extends Props = any> = (props: P) => any;
// eslint-disable-next-line @typescript-eslint/naming-convention
export type FC_withDebug = FC & { DEBUG_contentComponentName?: string };

export enum VirtualElementTypesEnum {
  Empty,
  Text,
  Tag,
  Component,
  Fragment,
}

interface VirtualElementEmpty {
  type: VirtualElementTypesEnum.Empty;
  target?: Node;
}

interface VirtualElementText {
  type: VirtualElementTypesEnum.Text;
  target?: Node;
  value: string;
}

export interface VirtualElementTag {
  type: VirtualElementTypesEnum.Tag;
  target?: HTMLElement;
  tag: string;
  props: Props;
  children: VirtualElementChildren;
}

export interface VirtualElementComponent {
  type: VirtualElementTypesEnum.Component;
  componentInstance: ComponentInstance;
  props: Props;
  children: VirtualElementChildren;
}

export interface VirtualElementFragment {
  type: VirtualElementTypesEnum.Fragment;
  children: VirtualElementChildren;
}

export type StateHookSetter<T> = (newValue: ((current: T) => T) | T) => void;

interface ComponentInstance {
  id: number;
  $element: VirtualElementComponent;
  Component: FC;
  name: string;
  props: Props;
  renderedValue?: any;
  isMounted: boolean;
  hooks: {
    state: {
      cursor: number;
      byCursor: {
        value: any;
        nextValue: any;
        setter: StateHookSetter<any>;
      }[];
    };
    effects: {
      cursor: number;
      byCursor: {
        dependencies?: readonly any[];
        schedule: NoneToVoidFunction;
        cleanup?: NoneToVoidFunction;
        releaseSignals?: NoneToVoidFunction;
      }[];
    };
    memos: {
      cursor: number;
      byCursor: {
        value: any;
        dependencies: any[];
      }[];
    };
    refs: {
      cursor: number;
      byCursor: {
        current: any;
      }[];
    };
  };
  prepareForFrame?: () => void;
  forceUpdate?: () => void;
  onUpdate?: () => void;
}

export type VirtualElement =
  | VirtualElementEmpty
  | VirtualElementText
  | VirtualElementTag
  | VirtualElementComponent
  | VirtualElementFragment;
export type VirtualElementParent =
  | VirtualElementTag
  | VirtualElementComponent
  | VirtualElementFragment;
export type VirtualElementChildren = VirtualElement[];
export type VirtualElementReal = Exclude<
  VirtualElement,
  VirtualElementComponent | VirtualElementFragment
>;

// Compatibility with JSX types
export type TeactNode = ReactElement | string | number | boolean | TeactNode[];

type Effect = () => NoneToVoidFunction | void;
type EffectCleanup = NoneToVoidFunction;

const Fragment = Symbol("Fragment");

const DEBUG_RENDER_THRESHOLD = 7;
const DEBUG_EFFECT_THRESHOLD = 7;
const DEBUG_SILENT_RENDERS_FOR = new Set([
  "TeactMemoWrapper",
  "TeactNContainer",
  "Button",
  "ListItem",
  "MenuItem",
]);

let lastComponentId = 0;
let renderingInstance: ComponentInstance;

export function isEmptyElement(
  $element: VirtualElement
): $element is VirtualElementEmpty {
  return $element.type === VirtualElementTypesEnum.Empty;
}

export function isTextElement(
  $element: VirtualElement
): $element is VirtualElementText {
  return $element.type === VirtualElementTypesEnum.Text;
}

export function isTagElement(
  $element: VirtualElement
): $element is VirtualElementTag {
  return $element.type === VirtualElementTypesEnum.Tag;
}

export function isComponentElement(
  $element: VirtualElement
): $element is VirtualElementComponent {
  return $element.type === VirtualElementTypesEnum.Component;
}

export function isFragmentElement(
  $element: VirtualElement
): $element is VirtualElementFragment {
  return $element.type === VirtualElementTypesEnum.Fragment;
}

export function isParentElement(
  $element: VirtualElement
): $element is VirtualElementParent {
  return (
    isTagElement($element) ||
    isComponentElement($element) ||
    isFragmentElement($element)
  );
}

function createElement(
  source: string | FC | typeof Fragment,
  props: Props,
  ...children: any[]
): VirtualElementParent | VirtualElementChildren {
  children = children.flat();

  if (source === Fragment) {
    return buildFragmentElement(children);
  } else if (typeof source === "function") {
    return createComponentInstance(source, props || {}, children);
  } else {
    return buildTagElement(source, props || {}, children);
  }
}

function buildFragmentElement(children: any[]): VirtualElementFragment {
  return {
    type: VirtualElementTypesEnum.Fragment,
    children: dropEmptyTail(children, true).map(buildChildElement),
  };
}

function createComponentInstance(
  Component: FC,
  props: Props,
  children: any[]
): VirtualElementComponent {
  let parsedChildren: any | any[] | undefined;
  if (children.length === 0) {
    parsedChildren = undefined;
  } else if (children.length === 1) {
    [parsedChildren] = children;
  } else {
    parsedChildren = children;
  }

  const componentInstance: ComponentInstance = {
    id: ++lastComponentId,
    $element: {} as VirtualElementComponent,
    Component,
    name: Component.name,
    props: {
      ...props,
      ...(parsedChildren && { children: parsedChildren }),
    },
    isMounted: false,
    hooks: {
      state: {
        cursor: 0,
        byCursor: [],
      },
      effects: {
        cursor: 0,
        byCursor: [],
      },
      memos: {
        cursor: 0,
        byCursor: [],
      },
      refs: {
        cursor: 0,
        byCursor: [],
      },
    },
  };

  componentInstance.$element = buildComponentElement(componentInstance);

  return componentInstance.$element;
}

function buildComponentElement(
  componentInstance: ComponentInstance,
  children: VirtualElementChildren = []
): VirtualElementComponent {
  return {
    type: VirtualElementTypesEnum.Component,
    componentInstance,
    props: componentInstance.props,
    children: dropEmptyTail(children, true).map(buildChildElement),
  };
}

function buildTagElement(
  tag: string,
  props: Props,
  children: any[]
): VirtualElementTag {
  return {
    type: VirtualElementTypesEnum.Tag,
    tag,
    props,
    children: dropEmptyTail(children).map(buildChildElement),
  };
}

// We only need placeholders in the middle of collection (to ensure other elements order).
function dropEmptyTail(children: any[], noEmpty = false) {
  let i = children.length - 1;

  for (; i >= 0; i--) {
    if (!isEmptyPlaceholder(children[i])) {
      break;
    }
  }

  if (i === children.length - 1) {
    return children;
  }

  if (i === -1 && noEmpty) {
    return children.slice(0, 1);
  }

  return children.slice(0, i + 1);
}

function isEmptyPlaceholder(child: any) {
  // eslint-disable-next-line no-null/no-null
  return child === false || child === null || child === undefined;
}

function buildChildElement(child: any): VirtualElement {
  if (isEmptyPlaceholder(child)) {
    return buildEmptyElement();
  } else if (isParentElement(child)) {
    return child;
  } else {
    return buildTextElement(child);
  }
}

function buildTextElement(value: any): VirtualElementText {
  return {
    type: VirtualElementTypesEnum.Text,
    value: String(value),
  };
}

function buildEmptyElement(): VirtualElementEmpty {
  return { type: VirtualElementTypesEnum.Empty };
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const DEBUG_components: AnyLiteral = {
  TOTAL: { componentName: "TOTAL", renderCount: 0 },
};

document.addEventListener("dblclick", () => {
  // eslint-disable-next-line no-console
  console.warn(
    "COMPONENTS",
    orderBy(Object.values(DEBUG_components), "renderCount", "desc")
  );
});

let instancesPendingUpdate = new Set<ComponentInstance>();
let idsToExcludeFromUpdate = new Set<number>();
let pendingEffects = new Map<string, Effect>();
let pendingCleanups = new Map<string, EffectCleanup>();
let pendingLayoutEffects = new Map<string, Effect>();
let pendingLayoutCleanups = new Map<string, EffectCleanup>();
let areImmediateEffectsPending = false;

/*
  Order:
  - component effect cleanups
  - component effects
  - measure tasks
  - mutation tasks
  - component updates
  - component layout effect cleanups
  - component layout effects
  - forced layout measure tasks
  - forced layout mutation tasks
 */

const runUpdatePassOnRaf = throttleWith(requestMeasure, () => {
  areImmediateEffectsPending = true;

  idsToExcludeFromUpdate = new Set();
  const instancesToUpdate = Array.from(instancesPendingUpdate).sort(
    (a, b) => a.id - b.id
  );
  instancesPendingUpdate = new Set();

  const currentCleanups = pendingCleanups;
  pendingCleanups = new Map();
  currentCleanups.forEach((cb) => cb());

  const currentEffects = pendingEffects;
  pendingEffects = new Map();
  currentEffects.forEach((cb) => cb());

  requestMutation(() => {
    instancesToUpdate.forEach(prepareComponentForFrame);
    instancesToUpdate.forEach((instance) => {
      if (idsToExcludeFromUpdate!.has(instance.id)) {
        return;
      }

      forceUpdateComponent(instance);
    });

    areImmediateEffectsPending = false;
    runImmediateEffects();
  });
});

export function willRunImmediateEffects() {
  return areImmediateEffectsPending;
}

export function runImmediateEffects() {
  const currentLayoutCleanups = pendingLayoutCleanups;
  pendingLayoutCleanups = new Map();
  currentLayoutCleanups.forEach((cb) => cb());

  const currentLayoutEffects = pendingLayoutEffects;
  pendingLayoutEffects = new Map();
  currentLayoutEffects.forEach((cb) => cb());
}

export function renderComponent(componentInstance: ComponentInstance) {
  idsToExcludeFromUpdate.add(componentInstance.id);

  const { Component, props } = componentInstance;
  let newRenderedValue: any;

  safeExec(
    () => {
      renderingInstance = componentInstance;
      componentInstance.hooks.state.cursor = 0;
      componentInstance.hooks.effects.cursor = 0;
      componentInstance.hooks.memos.cursor = 0;
      componentInstance.hooks.refs.cursor = 0;

      // eslint-disable-next-line @typescript-eslint/naming-convention
      let DEBUG_startAt: number | undefined;
      if (DEBUG) {
        const componentName = componentInstance.name;
        if (!DEBUG_components[componentName]) {
          DEBUG_components[componentName] = {
            componentName,
            renderCount: 0,
            renderTimes: [],
          };
        }

        if (DEBUG_MORE) {
          if (!DEBUG_SILENT_RENDERS_FOR.has(componentName)) {
            // eslint-disable-next-line no-console
            console.log(`[Teact] Render ${componentName}`);
          }
        }

        DEBUG_startAt = performance.now();
      }

      newRenderedValue = Component(props);

      if (DEBUG) {
        const duration = performance.now() - DEBUG_startAt!;
        const componentName = componentInstance.name;
        if (duration > DEBUG_RENDER_THRESHOLD) {
          // eslint-disable-next-line no-console
          console.warn(
            `[Teact] Slow component render: ${componentName}, ${Math.round(
              duration
            )} ms`
          );
        }
        DEBUG_components[componentName].renderTimes.push(duration);
        DEBUG_components[componentName].renderCount++;
        DEBUG_components.TOTAL.renderCount++;

        if (DEBUG_MORE) {
          incrementOverlayCounter(`${componentName} renders`);
          incrementOverlayCounter(`${componentName} duration`, duration);
        }
      }
    },
    () => {
      // eslint-disable-next-line no-console
      console.error(
        `[Teact] Error while rendering component ${componentInstance.name}`
      );

      newRenderedValue = componentInstance.renderedValue;
    }
  );

  if (
    componentInstance.isMounted &&
    newRenderedValue === componentInstance.renderedValue
  ) {
    return componentInstance.$element;
  }

  componentInstance.renderedValue = newRenderedValue;

  const children = Array.isArray(newRenderedValue)
    ? newRenderedValue
    : [newRenderedValue];
  componentInstance.$element = buildComponentElement(
    componentInstance,
    children
  );

  return componentInstance.$element;
}

export function hasElementChanged($old: VirtualElement, $new: VirtualElement) {
  if (typeof $old !== typeof $new) {
    return true;
  } else if ($old.type !== $new.type) {
    return true;
  } else if (isTextElement($old) && isTextElement($new)) {
    return $old.value !== $new.value;
  } else if (isTagElement($old) && isTagElement($new)) {
    return $old.tag !== $new.tag || $old.props.key !== $new.props.key;
  } else if (isComponentElement($old) && isComponentElement($new)) {
    return (
      $old.componentInstance.Component !== $new.componentInstance.Component ||
      $old.props.key !== $new.props.key
    );
  }

  return false;
}

export function mountComponent(componentInstance: ComponentInstance) {
  renderComponent(componentInstance);
  componentInstance.isMounted = true;
  return componentInstance.$element;
}

export function unmountComponent(componentInstance: ComponentInstance) {
  if (!componentInstance.isMounted) {
    return;
  }

  idsToExcludeFromUpdate.add(componentInstance.id);

  componentInstance.hooks.effects.byCursor.forEach((effect) => {
    if (effect.cleanup) {
      safeExec(effect.cleanup);
    }

    effect.cleanup = undefined;
    effect.releaseSignals?.();
  });

  componentInstance.isMounted = false;

  helpGc(componentInstance);
}

// We need to remove all references to DOM objects. We also clean all other references, just in case
function helpGc(componentInstance: ComponentInstance) {
  componentInstance.hooks.effects.byCursor.forEach((hook) => {
    hook.schedule = undefined as any;
    hook.cleanup = undefined as any;
    hook.releaseSignals = undefined as any;
    hook.dependencies = undefined;
  });

  componentInstance.hooks.state.byCursor.forEach((hook) => {
    hook.value = undefined;
    hook.nextValue = undefined;
    hook.setter = undefined as any;
  });

  componentInstance.hooks.memos.byCursor.forEach((hook) => {
    hook.value = undefined as any;
    hook.dependencies = undefined as any;
  });

  componentInstance.hooks.refs.byCursor.forEach((hook) => {
    hook.current = undefined as any;
  });

  componentInstance.hooks = undefined as any;
  componentInstance.$element = undefined as any;
  componentInstance.renderedValue = undefined;
  componentInstance.Component = undefined as any;
  componentInstance.props = undefined as any;
  componentInstance.onUpdate = undefined;
}

function prepareComponentForFrame(componentInstance: ComponentInstance) {
  if (!componentInstance.isMounted) {
    return;
  }

  componentInstance.hooks.state.byCursor.forEach((hook) => {
    hook.value = hook.nextValue;
  });
}

function forceUpdateComponent(componentInstance: ComponentInstance) {
  if (!componentInstance.isMounted || !componentInstance.onUpdate) {
    return;
  }

  const currentElement = componentInstance.$element;

  renderComponent(componentInstance);

  if (componentInstance.$element !== currentElement) {
    componentInstance.onUpdate();
  }
}
export {
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useCallback,
  useRef,
  memo,
} from "react";

export default {
  createElement,
  Fragment,
};
