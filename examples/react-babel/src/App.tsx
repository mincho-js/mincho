import { styled } from "@mincho-js/react";

const BaseComponent = styled("div", {
  base: {
    fontWeight: "bold",
  },
});

const Container = styled(BaseComponent, {
  base: {
    backgroundColor: "red",
    padding: "20px",
    margin: "20px",
    borderRadius: "5px",
    color: "white",
    fontFamily: "sans-serif",
  },
  variants: {
    size: {
      small: {
        padding: "10px",
      },
      medium: {
        padding: "20px",
      },
      large: {
        padding: "30px",
      },
    },
    color: {
      red: {
        backgroundColor: "red",
      },
      blue: {
        backgroundColor: "blue",
      },
    },
  },
  compoundVariants: [
    {
      variants: { size: "small", color: "blue" },
      style: {
        color: "green",
      },
    },
    {
      variants: { size: "large", color: "blue" },
      style: {
        color: "yellow",
      },
    },
  ],
  defaultVariants: {
    size: "medium",
    color: "red",
  },
});

function App() {
  return (
    <Container size="large" color="blue">
      Hello World
    </Container>
  );
}

export default App;
