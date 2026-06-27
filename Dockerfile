FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash

# Install opencode
RUN curl -fsSL https://opencode.ai/install | bash

ENV PATH="/root/.local/bin:/root/.opencode/bin:/root/.bun/bin:${PATH}"

WORKDIR /workspace
