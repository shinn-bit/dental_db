type PageHeadingProps = {
  title: string;
};

export function PageHeading({ title }: PageHeadingProps) {
  return (
    <div className="page-head">
      <h1 className="page-title">{title}</h1>
    </div>
  );
}
