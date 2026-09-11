interface Props {
  msg: string
}

export default function Hello(props: Props) {
  return (
    <section class="hello">
      <p>{props.msg}</p>
      <span data-x="1" />
    </section>
  )
}
