FROM denoland/deno:alpine
WORKDIR /app
COPY deno.json .
COPY main.ts .
RUN deno install --allow-scripts
RUN deno cache main.ts
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
