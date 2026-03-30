function envFlagTrue(name) {
    return String(process.env[name] ?? "")
      .trim()
      .toLowerCase() === "true";
  }
  
  const GOPEAK_DISCOVERY_DEBUG = envFlagTrue("DEBUG_GOPEAK_DISCOVERY");
  
  export { GOPEAK_DISCOVERY_DEBUG };
  
  