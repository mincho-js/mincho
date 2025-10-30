import { styled } from "@mincho-js/react";

const BaseComponent = styled("div", {
  base: {
    fontWeight: "bold"
  }
});

const Container = styled(BaseComponent, {
  base: {
    backgroundColor: "red",
    padding: "20px",
    margin: "20px",
    borderRadius: "5px",
    color: "white",
    fontFamily: "sans-serif"
  },
  variants: {
    size: {
      small: {
        padding: "10px"
      },
      medium: {
        padding: "20px"
      },
      large: {
        padding: "30px"
      }
    },
    color: {
      red: {
        backgroundColor: "red"
      },
      blue: {
        backgroundColor: "blue"
      }
    }
  },
  compoundVariants: ({ size, color }) => [
    {
      condition: [size.small, color.blue],
      style: {
        color: "green"
      }
    },
    {
      condition: [size.large, color.blue],
      style: {
        color: "yellow"
      }
    }
  ],
  defaultVariants: {
    size: "medium",
    color: "red"
  }
});

function App() {
  return (
    <Container size="medium" color="red">
      hello world
    </Container>
  );
}

export default App;
