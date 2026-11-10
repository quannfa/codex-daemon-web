import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
export type SettingsPage = { id: string; title: string; description?: string; icon?: ReactNode; content?: ReactNode; children?: SettingsPage[] };
export default function SettingsNavigation({ pages }: { pages: SettingsPage[] }) {
  const [path, setPath] = useState<string[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  const trail: SettingsPage[] = [];
  let children = pages;
  for (const id of path) {
    const entry = children.find(item => item.id === id);
    if (!entry) break;
    trail.push(entry); children = entry.children || [];
  }
  const current = trail.at(-1);
  useLayoutEffect(() => {
    if (mounted.current) {
      heading.current?.focus({preventScroll: true});
      heading.current?.closest(".settings-panel")?.scrollTo({top: 0});
    }
    mounted.current = true;
  }, [path]);
  return <div className="settings-navigation">
    {current ? <nav className="settings-breadcrumb" aria-label="Settings navigation">
      <button type="button" onClick={() => setPath(path.slice(0, -1))}><ArrowLeft size={15} /><span>Back</span></button>
      <button type="button" onClick={() => setPath([])}>All settings</button>
      {trail.slice(0, -1).map((item, index) => <button type="button" key={item.id} onClick={() => setPath(path.slice(0, index + 1))}>{item.title}</button>)}
    </nav> : null}
    <h3 className="settings-page-title" tabIndex={-1} ref={heading}>{current?.title || "All settings"}</h3>
    {current?.description ? <p className="settings-page-note">{current.description}</p> : null}
    {children.length ? <div className="settings-category-list">{children.map(item => <button type="button" className="settings-category" key={item.id} onClick={() => setPath([...path, item.id])}>
      {item.icon ? <span className="settings-category-icon">{item.icon}</span> : null}
      <span className="settings-category-copy"><strong>{item.title}</strong>{item.description ? <span>{item.description}</span> : null}</span><ChevronRight size={18} />
    </button>)}</div> : <div className="settings-page-content" key={current?.id}>{current?.content}</div>}
  </div>;
}
